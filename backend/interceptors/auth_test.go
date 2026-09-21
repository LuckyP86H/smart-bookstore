package interceptors

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	bookstorev1 "github.com/LuckyP86H/smart-bookstore/gen"
	"github.com/LuckyP86H/smart-bookstore/gen/bookstorev1connect"
)

type stubMerchant struct {
	bookstorev1connect.UnimplementedMerchantServiceHandler
}

func (stubMerchant) LookupBookByISBN(context.Context, *connect.Request[bookstorev1.LookupBookByISBNRequest]) (*connect.Response[bookstorev1.LookupBookByISBNResponse], error) {
	return connect.NewResponse(&bookstorev1.LookupBookByISBNResponse{Title: "reached handler"}), nil
}

// A real ConnectRPC server with the auth interceptor installed. The database
// is nil: public procedures must be served without ever consulting it, and
// unauthenticated calls to protected ones must be rejected before it is.
func newMerchantClient(t *testing.T) bookstorev1connect.MerchantServiceClient {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle(bookstorev1connect.NewMerchantServiceHandler(stubMerchant{},
		connect.WithInterceptors(NewAuthInterceptor(nil))))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return bookstorev1connect.NewMerchantServiceClient(http.DefaultClient, srv.URL)
}

func TestLookupBookByISBNIsPublic(t *testing.T) {
	resp, err := newMerchantClient(t).LookupBookByISBN(context.Background(),
		connect.NewRequest(&bookstorev1.LookupBookByISBNRequest{Isbn: "9780441172719"}))
	if err != nil {
		t.Fatalf("unauthenticated ISBN lookup rejected: %v", err)
	}
	if resp.Msg.Title != "reached handler" {
		t.Errorf("got %+v", resp.Msg)
	}
}

func TestOtherMerchantProceduresStillRequireAuth(t *testing.T) {
	_, err := newMerchantClient(t).GetMerchantBooks(context.Background(),
		connect.NewRequest(&bookstorev1.GetMerchantBooksRequest{}))
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}
