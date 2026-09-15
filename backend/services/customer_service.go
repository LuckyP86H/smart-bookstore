package services

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	"github.com/LuckyP86H/smart-bookstore/db"
	bookstorev1 "github.com/LuckyP86H/smart-bookstore/gen"
	"github.com/LuckyP86H/smart-bookstore/interceptors"
)

type CustomerServiceServer struct {
	db *db.Database
}

func NewCustomerServiceServer(database *db.Database) *CustomerServiceServer {
	return &CustomerServiceServer{
		db: database,
	}
}

func (s *CustomerServiceServer) GetAvailableBooks(
	ctx context.Context,
	req *connect.Request[bookstorev1.GetAvailableBooksRequest],
) (*connect.Response[bookstorev1.GetAvailableBooksResponse], error) {
	filter := db.BookFilter{
		SearchQuery:  strings.ToLower(req.Msg.SearchQuery),
		GenreFilter:  req.Msg.GenreFilter.String(),
		AuthorFilter: strings.ToLower(req.Msg.AuthorFilter),
		MinPrice:     req.Msg.MinPrice,
		MaxPrice:     req.Msg.MaxPrice,
		SortOrder:    req.Msg.SortOrder.String(),
		Page:         req.Msg.Page,
		PageSize:     req.Msg.PageSize,
	}

	books, totalCount, err := s.db.GetAvailableBooks(filter)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	protoBooks := make([]*bookstorev1.Book, len(books))
	for i, book := range books {
		protoBooks[i] = dbBookToProto(book)
	}

	return connect.NewResponse(&bookstorev1.GetAvailableBooksResponse{
		Books:      protoBooks,
		TotalCount: totalCount,
		Page:       req.Msg.Page,
		PageSize:   req.Msg.PageSize,
	}), nil
}

func (s *CustomerServiceServer) GetBookDetails(
	ctx context.Context,
	req *connect.Request[bookstorev1.GetBookDetailsRequest],
) (*connect.Response[bookstorev1.GetBookDetailsResponse], error) {
	book, err := s.db.GetBookByID(req.Msg.BookId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}

	return connect.NewResponse(&bookstorev1.GetBookDetailsResponse{
		Book: dbBookToProto(book),
	}), nil
}

func (s *CustomerServiceServer) PurchaseBook(
	ctx context.Context,
	req *connect.Request[bookstorev1.PurchaseBookRequest],
) (*connect.Response[bookstorev1.PurchaseBookResponse], error) {
	customerID := interceptors.GetStoreID(ctx)
	if customerID == 0 {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("unauthorized"))
	}

	quantity := req.Msg.Quantity
	if quantity <= 0 {
		quantity = 1
	}

	sale, err := s.db.PurchaseBook(req.Msg.BookId, customerID, quantity)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	return connect.NewResponse(&bookstorev1.PurchaseBookResponse{
		Message: fmt.Sprintf("Successfully purchased %d copy(ies)", quantity),
		Sale:    dbSaleToProto(sale),
	}), nil
}

func (s *CustomerServiceServer) CheckoutCart(
	ctx context.Context,
	req *connect.Request[bookstorev1.CheckoutCartRequest],
) (*connect.Response[bookstorev1.CheckoutCartResponse], error) {
	customerID := interceptors.GetStoreID(ctx)
	if customerID == 0 {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("unauthorized"))
	}

	if len(req.Msg.Items) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("cart is empty"))
	}

	// Convert proto items to DB format
	items := make([]struct {
		BookID   int64
		Quantity int32
	}, len(req.Msg.Items))

	for i, item := range req.Msg.Items {
		items[i].BookID = item.BookId
		items[i].Quantity = item.Quantity
		if items[i].Quantity <= 0 {
			items[i].Quantity = 1
		}
	}

	sales, err := s.db.CheckoutCart(customerID, items)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	protoSales := make([]*bookstorev1.Sale, len(sales))
	for i, sale := range sales {
		protoSales[i] = dbSaleToProto(sale)
	}

	return connect.NewResponse(&bookstorev1.CheckoutCartResponse{
		Message: fmt.Sprintf("Successfully checked out %d item(s)", len(sales)),
		Sales:   protoSales,
	}), nil
}

func (s *CustomerServiceServer) AddReview(
	ctx context.Context,
	req *connect.Request[bookstorev1.AddReviewRequest],
) (*connect.Response[bookstorev1.AddReviewResponse], error) {
	customerID := interceptors.GetStoreID(ctx)
	if customerID == 0 {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("unauthorized"))
	}

	if req.Msg.Rating < 1 || req.Msg.Rating > 5 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("rating must be between 1 and 5"))
	}

	review, err := s.db.AddReview(req.Msg.BookId, customerID, req.Msg.Rating, req.Msg.ReviewText)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	return connect.NewResponse(&bookstorev1.AddReviewResponse{
		Review: dbReviewToProto(review),
	}), nil
}

func (s *CustomerServiceServer) GetBookReviews(
	ctx context.Context,
	req *connect.Request[bookstorev1.GetBookReviewsRequest],
) (*connect.Response[bookstorev1.GetBookReviewsResponse], error) {
	reviews, err := s.db.GetBookReviews(req.Msg.BookId)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	protoReviews := make([]*bookstorev1.Review, len(reviews))
	for i, review := range reviews {
		protoReviews[i] = dbReviewToProto(review)
	}

	return connect.NewResponse(&bookstorev1.GetBookReviewsResponse{
		Reviews: protoReviews,
	}), nil
}

func (s *CustomerServiceServer) GetPurchaseHistory(
	ctx context.Context,
	req *connect.Request[bookstorev1.GetPurchaseHistoryRequest],
) (*connect.Response[bookstorev1.GetPurchaseHistoryResponse], error) {
	customerID := interceptors.GetStoreID(ctx)
	if customerID == 0 {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("unauthorized"))
	}

	purchases, err := s.db.GetPurchaseHistory(customerID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	protoPurchases := make([]*bookstorev1.Sale, len(purchases))
	for i, purchase := range purchases {
		protoPurchases[i] = dbSaleToProto(purchase)
	}

	return connect.NewResponse(&bookstorev1.GetPurchaseHistoryResponse{
		Purchases: protoPurchases,
	}), nil
}

func dbReviewToProto(review *db.Review) *bookstorev1.Review {
	return &bookstorev1.Review{
		Id:           review.ID,
		BookId:       review.BookID,
		CustomerId:   review.CustomerID,
		CustomerName: review.CustomerName,
		Rating:       review.Rating,
		ReviewText:   review.ReviewText,
		CreatedAt:    review.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
	}
}
