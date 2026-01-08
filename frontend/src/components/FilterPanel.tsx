import { Genre } from '../gen/bookstore_pb';
import './FilterPanel.css';

interface FilterPanelProps {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  genreFilter: Genre;
  setGenreFilter: (genre: Genre) => void;
  authorFilter: string;
  setAuthorFilter: (author: string) => void;
  minPrice: number;
  setMinPrice: (price: number) => void;
  maxPrice: number;
  setMaxPrice: (price: number) => void;
  onClear: () => void;
}

function FilterPanel({
  searchQuery,
  setSearchQuery,
  genreFilter,
  setGenreFilter,
  authorFilter,
  setAuthorFilter,
  minPrice,
  setMinPrice,
  maxPrice,
  setMaxPrice,
  onClear,
}: FilterPanelProps) {
  const genres = [
    { value: Genre.GENRE_UNSPECIFIED, label: 'All Genres' },
    { value: Genre.FICTION, label: 'Fiction' },
    { value: Genre.NON_FICTION, label: 'Non-Fiction' },
    { value: Genre.SCIENCE, label: 'Science' },
    { value: Genre.HISTORY, label: 'History' },
    { value: Genre.BIOGRAPHY, label: 'Biography' },
    { value: Genre.MYSTERY, label: 'Mystery' },
    { value: Genre.ROMANCE, label: 'Romance' },
    { value: Genre.FANTASY, label: 'Fantasy' },
    { value: Genre.SCIENCE_FICTION, label: 'Science Fiction' },
    { value: Genre.THRILLER, label: 'Thriller' },
    { value: Genre.HORROR, label: 'Horror' },
    { value: Genre.SELF_HELP, label: 'Self Help' },
    { value: Genre.BUSINESS, label: 'Business' },
    { value: Genre.TECHNOLOGY, label: 'Technology' },
    { value: Genre.CHILDREN, label: 'Children' },
  ];

  return (
    <div className="filter-panel">
      <h3>🔍 Filters</h3>
      
      <div className="filter-group">
        <label>Search</label>
        <input
          type="text"
          placeholder="Search by title or author..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
      
      <div className="filter-group">
        <label>Genre</label>
        <select
          value={genreFilter}
          onChange={(e) => setGenreFilter(Number(e.target.value) as Genre)}
        >
          {genres.map((genre) => (
            <option key={genre.value} value={genre.value}>
              {genre.label}
            </option>
          ))}
        </select>
      </div>
      
      <div className="filter-group">
        <label>Author</label>
        <input
          type="text"
          placeholder="Filter by author..."
          value={authorFilter}
          onChange={(e) => setAuthorFilter(e.target.value)}
        />
      </div>
      
      <div className="filter-group">
        <label>Min Price</label>
        <input
          type="number"
          min="0"
          step="0.01"
          placeholder="0.00"
          value={minPrice || ''}
          onChange={(e) => setMinPrice(parseFloat(e.target.value) || 0)}
        />
      </div>
      
      <div className="filter-group">
        <label>Max Price</label>
        <input
          type="number"
          min="0"
          step="0.01"
          placeholder="No limit"
          value={maxPrice || ''}
          onChange={(e) => setMaxPrice(parseFloat(e.target.value) || 0)}
        />
      </div>
      
      <button className="btn-clear-filters" onClick={onClear}>
        Clear All Filters
      </button>
    </div>
  );
}

export default FilterPanel;
