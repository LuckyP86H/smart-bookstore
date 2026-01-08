import { Book, Genre, Review, Sale } from "../gen/bookstore_pb";

export type { Book, Review, Sale };

export { Genre };

export interface CartItem {
  book: Book;
  quantity: number;
}

export interface User {
  username: string;
  password: string;
  isCustomer: boolean;
}
