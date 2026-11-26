package graph

import (
	"context"
	"errors"
	"log"

	"github.com/99designs/gqlgen/graphql"
	"github.com/vektah/gqlparser/v2/gqlerror"
)

// MaskErrors decides what the caller reads of an error. Return a *gqlerror.Error from a resolver to tell the caller
// something; the message of any other error stays in the log.
func MaskErrors(ctx context.Context, err error) *gqlerror.Error {
	// gqlgen wraps what a resolver returned in a *gqlerror.Error whose Err is that error: look at what is inside.
	var outer *gqlerror.Error
	if errors.As(err, &outer) && outer.Err != nil {
		var meant *gqlerror.Error
		if !errors.As(outer.Err, &meant) {
			log.Printf("resolver error at %s: %v", outer.Path.String(), outer.Err)
			return &gqlerror.Error{Message: "Unexpected error.", Path: outer.Path}
		}
	}
	return graphql.DefaultErrorPresenter(ctx, err)
}
