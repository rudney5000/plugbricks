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

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

// Caller is who called, from a verified token.
type Caller struct {
	// Subject is the token's `sub`.
	Subject string
	// Name is `preferred_username`, else `sub`; for a service account, "service-account-<client>".
	Name string
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
		return &Caller{Subject: subject, Name: name, Scopes: strings.Fields(scope)}
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
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), callerKey{}, caller)))
		})
	}, nil
}
