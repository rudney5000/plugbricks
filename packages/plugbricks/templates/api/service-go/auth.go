package main

// The token check of this service. With an identity provider in the platform (the oidc capability), plugbricks gives the
// service OIDC_ISSUER, OIDC_JWKS_URL and OIDC_AUDIENCE, and the router sends every request with the caller's token. This
// service checks that token itself too: a service of the platform that calls it directly, past the router, gets nothing
// without a valid one. Without a provider none of the three is set and the service answers without a token.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"

	"github.com/99designs/gqlgen/graphql"
	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
	"github.com/vektah/gqlparser/v2/ast"
	"github.com/vektah/gqlparser/v2/gqlerror"
)

// Caller is who called, from a verified token.
type Caller struct {
	// Subject is the token's `sub`.
	Subject string
	// Name is `preferred_username`, else `sub`; for a service account, "service-account-<client>".
	Name string
	// Client is the client the token was issued to (`azp`), when it says.
	Client string
	// Roles are the client roles of the token (`resource_access.<client>.roles`), by client; empty when it carries none.
	Roles map[string][]string
	// Scopes is the `scope` claim of the token, space-separated in it.
	Scopes []string
}

type callerKey struct{}

// CallerFrom returns the caller of a request that went through RequireToken, and false without a token check. Use it in a
// resolver with the context it is given: caller, ok := CallerFrom(ctx).
func CallerFrom(ctx context.Context) (*Caller, bool) {
	caller, ok := ctx.Value(callerKey{}).(*Caller)
	return caller, ok
}

var bearer = regexp.MustCompile(`(?i)^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$`)

// clientRoles reads the client roles of a token from its `resource_access` claim. Anything that is not a list of strings is
// ignored.
func clientRoles(claim any) map[string][]string {
	out := map[string][]string{}
	access, _ := claim.(map[string]any)
	for client, entry := range access {
		fields, _ := entry.(map[string]any)
		list, ok := fields["roles"].([]any)
		if !ok {
			continue
		}
		roles := []string{}
		for _, r := range list {
			if role, ok := r.(string); ok {
				roles = append(roles, role)
			}
		}
		out[client] = roles
	}
	return out
}

// tokenCheck returns a function that turns an Authorization header into the Caller of a valid token, nil otherwise.
func tokenCheck(issuer, audience string, keys jwt.Keyfunc) func(string) *Caller {
	// RS256 only, as the router: no "none", no symmetric algorithm with the public key as the secret.
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(issuer),
		jwt.WithAudience(audience),
		jwt.WithExpirationRequired(),
	)
	return func(authorization string) *Caller {
		match := bearer.FindStringSubmatch(authorization)
		if match == nil {
			return nil
		}
		claims := jwt.MapClaims{}
		if _, err := parser.ParseWithClaims(match[1], claims, keys); err != nil {
			return nil
		}
		subject, _ := claims["sub"].(string)
		if subject == "" {
			return nil
		}
		name, _ := claims["preferred_username"].(string)
		if name == "" {
			name = subject
		}
		scope, _ := claims["scope"].(string)
		client, _ := claims["azp"].(string)
		return &Caller{Subject: subject, Name: name, Client: client, Roles: clientRoles(claims["resource_access"]), Scopes: strings.Fields(scope)}
	}
}

// RequireToken, from OIDC_ISSUER, OIDC_JWKS_URL and OIDC_AUDIENCE: a handler wrapper that answers 401 to a request without
// a valid token and gives the caller to the resolvers. Nil when none is set (no provider: no check). Some set and not all:
// an error, rather than serving without the check it was meant to make. A value is never printed.
//
// The keys are fetched when first needed, kept, refreshed every hour, and fetched again (at most every 5 minutes) for a
// key id they do not know.
func RequireToken() (func(http.Handler) http.Handler, error) {
	issuer, jwksURL, audience := os.Getenv("OIDC_ISSUER"), os.Getenv("OIDC_JWKS_URL"), os.Getenv("OIDC_AUDIENCE")
	if issuer == "" && jwksURL == "" && audience == "" {
		return nil, nil
	}
	var missing []string
	for _, v := range []struct{ name, value string }{{"OIDC_ISSUER", issuer}, {"OIDC_JWKS_URL", jwksURL}, {"OIDC_AUDIENCE", audience}} {
		if v.value == "" {
			missing = append(missing, v.name)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("incomplete OIDC configuration: missing %s; set all three or none", strings.Join(missing, ", "))
	}
	keys, err := keyfunc.NewDefaultCtx(context.Background(), []string{jwksURL})
	if err != nil {
		return nil, errors.New("OIDC_JWKS_URL is not a usable address")
	}
	check := tokenCheck(issuer, audience, keys.Keyfunc)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			caller := check(r.Header.Get("Authorization"))
			if caller == nil {
				w.Header().Set("content-type", "application/json")
				w.Header().Set("www-authenticate", `Bearer realm="plugbricks"`)
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"errors":[{"message":"unauthorized"}]}`))
				return
			}
			// A refused operation answers 403 (see RequireRoles); the flag is set while the request runs.
			refused := &refusal{}
			ctx := context.WithValue(context.WithValue(r.Context(), callerKey{}, caller), refusalKey{}, refused)
			next.ServeHTTP(&statusWriter{ResponseWriter: w, refused: refused}, r.WithContext(ctx))
		})
	}, nil
}

// Authorization is what this service asks of a token (D22), by operation class. Client is the OIDC client the roles belong
// to: this service's own (OIDC_CLIENT_ID), the one the provider made for it. A class with no role stays open to any valid
// token.
type Authorization struct {
	Client    string
	Queries   string
	Mutations string
}

// AuthorizationFromEnv reads AUTHORIZATION_QUERIES_ROLE and AUTHORIZATION_MUTATIONS_ROLE, which the platform injects when the
// manifest has an "authorization" block; nil when neither is set (a valid token is enough). Set without the token check, or
// without the client they belong to, it is an error: serving with a rule that cannot be applied would silently open the
// service.
func AuthorizationFromEnv() (*Authorization, error) {
	queries, mutations := os.Getenv("AUTHORIZATION_QUERIES_ROLE"), os.Getenv("AUTHORIZATION_MUTATIONS_ROLE")
	if queries == "" && mutations == "" {
		return nil, nil
	}
	if os.Getenv("OIDC_ISSUER") == "" {
		return nil, errors.New("incomplete authorization configuration: roles are set but there is no token check (OIDC_ISSUER)")
	}
	client := os.Getenv("OIDC_CLIENT_ID")
	if client == "" {
		return nil, errors.New("incomplete authorization configuration: roles are set but OIDC_CLIENT_ID, the client they belong to, is not")
	}
	return &Authorization{Client: client, Queries: queries, Mutations: mutations}, nil
}

// roleFor is the role an operation class asks for: "" for none. A class this service does not know (a subscription) is
// refused: ok is false.
func (a *Authorization) roleFor(operation ast.Operation) (role string, ok bool) {
	switch operation {
	case ast.Query:
		return a.Queries, true
	case ast.Mutation:
		return a.Mutations, true
	}
	return "", false
}

// mayRun is whether a caller may run this class of operation.
func (a *Authorization) mayRun(caller *Caller, operation ast.Operation) bool {
	role, ok := a.roleFor(operation)
	if !ok {
		return false
	}
	if role == "" {
		return true
	}
	for _, r := range caller.Roles[a.Client] {
		if r == role {
			return true
		}
	}
	return false
}

// RequireRoles makes the server stop an operation before any resolver runs when the verified caller lacks the role of its
// class. The error has the code FORBIDDEN and the HTTP status is 403: the token was valid, it is the caller that is not
// allowed (401 stays for a token that is not valid). Use it with RequireToken: without a caller, nothing passes.
func RequireRoles(api *handler.Server, rules *Authorization) {
	api.AroundOperations(func(ctx context.Context, next graphql.OperationHandler) graphql.ResponseHandler {
		operation := graphql.GetOperationContext(ctx).Operation.Operation
		if caller, ok := CallerFrom(ctx); ok && rules.mayRun(caller, operation) {
			return next(ctx)
		}
		if refused, ok := ctx.Value(refusalKey{}).(*refusal); ok {
			refused.set = true
		}
		message := "forbidden"
		if role, _ := rules.roleFor(operation); role != "" {
			message = fmt.Sprintf("forbidden: this token does not carry the role %q of client %q", role, rules.Client)
		}
		return graphql.OneShot(&graphql.Response{Errors: gqlerror.List{{Message: message, Extensions: map[string]any{"code": "FORBIDDEN"}}}})
	})
}

type refusalKey struct{}

// refusal says that an operation was refused, so that the answer gets the status 403.
type refusal struct{ set bool }

// statusWriter turns the status of an answer to a refused operation into 403.
type statusWriter struct {
	http.ResponseWriter
	refused *refusal
	wrote   bool
}

func (w *statusWriter) WriteHeader(status int) {
	if w.wrote {
		return
	}
	w.wrote = true
	if w.refused.set && status == http.StatusOK {
		status = http.StatusForbidden
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	w.WriteHeader(http.StatusOK)
	return w.ResponseWriter.Write(b)
}

// Flush keeps streaming responses working (gqlgen flushes what it writes).
func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
