package services

import (
	"context"
	"fmt"
	"time"

	"connectrpc.com/connect"
	"github.com/LuckyP86H/smart-bookstore/db"
	"github.com/LuckyP86H/smart-bookstore/external"
	bookstorev1 "github.com/LuckyP86H/smart-bookstore/gen"
	"github.com/LuckyP86H/smart-bookstore/interceptors"
)

type MerchantServiceServer struct {
	db          *db.Database
	googleBooks *external.GoogleBooksClient
}

func NewMerchantServiceServer(database *db.Database, googleBooks *external.GoogleBooksClient) *MerchantServiceServer {
	return &MerchantServiceServer{
		db:          database,
		googleBooks: googleBooks,
	}
}

func (s *MerchantServiceServer) AddBook(
	ctx context.Context,
	req *connect.Request[bookstorev1.AddBookRequest],
) (*connect.Response[bookstorev1.AddBookResponse], error) {
	storeID := interceptors.GetStoreID(ctx)
	if storeID == 0 {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("unauthorized"))
	}

	book, err := s.db.CreateBook(
		storeID,
		req.Msg.Isbn,
		req.Msg.Title,
		req.Msg.Author,
		req.Msg.Genre.String(),
		req.Msg.Publisher,
		req.Msg.PublicationYear,
		req.Msg.PageCount,
		req.Msg.Language,
		req.Msg.CoverImageUrl,
		req.Msg.Description,
		req.Msg.Price,
		req.Msg.StockQuantity,
	)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	return connect.NewResponse(&bookstorev1.AddBookResponse{
		Book: dbBookToProto(book),
	}), nil
}

func (s *MerchantServiceServer) RemoveBook(
	ctx context.Context,
	req *connect.Request[bookstorev1.RemoveBookRequest],
) (*connect.Response[bookstorev1.RemoveBookResponse], error) {
	storeID := interceptors.GetStoreID(ctx)
	if storeID == 0 {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("unauthorized"))
	}

	err := s.db.DeleteBook(req.Msg.BookId, storeID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	return connect.NewResponse(&bookstorev1.RemoveBookResponse{
		Message: "Book successfully removed",
	}), nil
}

func (s *MerchantServiceServer) UpdateStock(
	ctx context.Context,
	req *connect.Request[bookstorev1.UpdateStockRequest],
) (*connect.Response[bookstorev1.UpdateStockResponse], error) {
	storeID := interceptors.GetStoreID(ctx)
	if storeID == 0 {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("unauthorized"))
	}

	book, err := s.db.UpdateStock(req.Msg.BookId, storeID, req.Msg.QuantityToAdd)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	return connect.NewResponse(&bookstorev1.UpdateStockResponse{
		Book: dbBookToProto(book),
	}), nil
}

func (s *MerchantServiceServer) GetMerchantBooks(
	ctx context.Context,
	req *connect.Request[bookstorev1.GetMerchantBooksRequest],
) (*connect.Response[bookstorev1.GetMerchantBooksResponse], error) {
	storeID := interceptors.GetStoreID(ctx)
	if storeID == 0 {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("unauthorized"))
	}

	books, err := s.db.GetMerchantBooks(storeID, req.Msg.IncludeSoldOut)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	protoBooks := make([]*bookstorev1.Book, len(books))
	for i, book := range books {
		protoBooks[i] = dbBookToProto(book)
	}

	return connect.NewResponse(&bookstorev1.GetMerchantBooksResponse{
		Books: protoBooks,
	}), nil
}

func (s *MerchantServiceServer) GetSoldBooks(
	ctx context.Context,
	req *connect.Request[bookstorev1.GetSoldBooksRequest],
) (*connect.Response[bookstorev1.GetSoldBooksResponse], error) {
	storeID := interceptors.GetStoreID(ctx)
	if storeID == 0 {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("unauthorized"))
	}

	startDate, err := time.Parse(time.RFC3339, req.Msg.StartDate)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid start_date format"))
	}

	endDate, err := time.Parse(time.RFC3339, req.Msg.EndDate)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid end_date format"))
	}

	sales, err := s.db.GetSoldBooks(storeID, startDate, endDate)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	protoSales := make([]*bookstorev1.Sale, len(sales))
	for i, sale := range sales {
		protoSales[i] = dbSaleToProto(sale)
	}

	return connect.NewResponse(&bookstorev1.GetSoldBooksResponse{
		Sales: protoSales,
	}), nil
}

func (s *MerchantServiceServer) GetLowStockBooks(
	ctx context.Context,
	req *connect.Request[bookstorev1.GetLowStockBooksRequest],
) (*connect.Response[bookstorev1.GetLowStockBooksResponse], error) {
	storeID := interceptors.GetStoreID(ctx)
	if storeID == 0 {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("unauthorized"))
	}

	threshold := req.Msg.Threshold
	if threshold == 0 {
		threshold = 5 // default threshold
	}

	books, err := s.db.GetLowStockBooks(storeID, threshold)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	protoBooks := make([]*bookstorev1.Book, len(books))
	for i, book := range books {
		protoBooks[i] = dbBookToProto(book)
	}

	return connect.NewResponse(&bookstorev1.GetLowStockBooksResponse{
		Books: protoBooks,
	}), nil
}

func (s *MerchantServiceServer) LookupBookByISBN(
	ctx context.Context,
	req *connect.Request[bookstorev1.LookupBookByISBNRequest],
) (*connect.Response[bookstorev1.LookupBookByISBNResponse], error) {
	// This endpoint doesn't require merchant auth (can be used before adding book)
	if req.Msg.Isbn == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("ISBN is required"))
	}

	bookInfo, err := s.googleBooks.LookupByISBN(req.Msg.Isbn)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}

	return connect.NewResponse(&bookstorev1.LookupBookByISBNResponse{
		Title:           bookInfo.Title,
		Author:          bookInfo.Author,
		Publisher:       bookInfo.Publisher,
		PublicationYear: bookInfo.PublicationYear,
		PageCount:       bookInfo.PageCount,
		Description:     bookInfo.Description,
		CoverImageUrl:   bookInfo.CoverImageURL,
		Categories:      bookInfo.Categories,
	}), nil
}

// Helper function to convert DB book to proto
func dbBookToProto(book *db.Book) *bookstorev1.Book {
	genre := bookstorev1.Genre_GENRE_UNSPECIFIED
	if g, ok := bookstorev1.Genre_value[book.Genre]; ok {
		genre = bookstorev1.Genre(g)
	}

	return &bookstorev1.Book{
		Id:              book.ID,
		StoreId:         book.StoreID,
		Isbn:            book.ISBN,
		Title:           book.Title,
		Author:          book.Author,
		Genre:           genre,
		Publisher:       book.Publisher,
		PublicationYear: book.PublicationYear,
		PageCount:       book.PageCount,
		Language:        book.Language,
		CoverImageUrl:   book.CoverImageURL,
		Description:     book.Description,
		Price:           book.Price,
		StockQuantity:   book.StockQuantity,
		TotalSold:       book.TotalSold,
		AverageRating:   book.AverageRating,
		CreatedAt:       book.CreatedAt.Format(time.RFC3339),
		StoreName:       book.StoreName,
	}
}

func dbSaleToProto(sale *db.Sale) *bookstorev1.Sale {
	return &bookstorev1.Sale{
		Id:              sale.ID,
		BookId:          sale.BookID,
		BookTitle:       sale.BookTitle,
		CustomerId:      sale.CustomerID,
		CustomerName:    sale.CustomerName,
		Quantity:        sale.Quantity,
		PriceAtPurchase: sale.PriceAtPurchase,
		PurchasedAt:     sale.PurchasedAt.Format(time.RFC3339),
	}
}
