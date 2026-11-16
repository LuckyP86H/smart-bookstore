import { useEffect, useState } from 'react';
import { Code, ConnectError } from '@connectrpc/connect';
import type { createCustomerClient } from '../api/client';
import type { GetWorkResponse } from '../gen/bookstore_pb';
import './WorkPage.css';
import './synthetic-badge.css';

// The minimal work page (P4 PR 3, plan §8): one canonical work, its
// editions from the reference catalogue, and every store's offer of it,
// reached by clicking a listing's title in the grid. Step 7 (PR 6)
// completes this surface — buying from an offer, richer edition data —
// so what is here is deliberately the read-only skeleton.
//
// Disclosure (§4.4): synthetic listings are demo data. The page banners
// them at the top and badges each synthetic offer; demo reviews and
// ratings are never presented as real social proof without the label.

type CustomerClient = ReturnType<typeof createCustomerClient>;

interface WorkPageProps {
  client: CustomerClient;
  bookId: bigint;
  onBack: () => void;
}

function WorkPage({ client, bookId, onBack }: WorkPageProps) {
  const [work, setWork] = useState<GetWorkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await client.getWork({ bookId });
        if (!cancelled) {
          setWork(response);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ConnectError && err.code === Code.NotFound) {
          setError('This book is not linked to a work page yet.');
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load the work page');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, bookId]);

  return (
    <div className="work-page">
      <button className="work-back" onClick={onBack}>
        ← Back to books
      </button>

      {error && <p className="error">{error}</p>}
      {!work && !error && <p>Loading work…</p>}

      {work && (
        <>
          <h2 className="work-title">{work.title}</h2>
          {work.authorDisplay && <p className="work-author">by {work.authorDisplay}</p>}

          {work.hasSyntheticListings && (
            <p className="work-synthetic-banner">
              ⚠️ Demo data: some listings on this page are synthetic fixtures, not real
              inventory.
            </p>
          )}

          {work.summaryEn && <p className="work-summary">{work.summaryEn}</p>}
          {work.summaryZh && <p className="work-summary">{work.summaryZh}</p>}

          {work.categories.length > 0 && (
            <div className="work-categories">
              {work.categories.map((category) => (
                <span key={category} className="work-category-chip">
                  {category}
                </span>
              ))}
            </div>
          )}

          <p className="work-aggregates">
            {work.reviewCount > 0
              ? `${work.reviewCount} review${work.reviewCount === 1 ? '' : 's'}${
                  // §4.4: the aggregate must say what it includes —
                  // demo reviews are never silently averaged in
                  // (fix round item 12).
                  work.reviews.some((entry) => entry.isSynthetic)
                    ? ' (including demo reviews)'
                    : ''
                } · average ${work.meanRating.toFixed(1)}`
              : 'No reviews yet'}
            {work.offers.length > 0 &&
              ` · ${work.offers.length} offer${work.offers.length === 1 ? '' : 's'} from $${work.minPrice.toFixed(2)} to $${work.maxPrice.toFixed(2)}`}
          </p>

          <h3>Editions</h3>
          {work.editions.length === 0 ? (
            <p className="work-empty">No catalogue editions recorded for this work yet.</p>
          ) : (
            <ul className="work-editions">
              {work.editions.map((edition) => (
                <li key={edition.editionId.toString()}>
                  <span className="work-edition-title">{edition.title}</span>
                  {edition.publisher && <> · {edition.publisher}</>}
                  {edition.publishYear > 0 && <> · {edition.publishYear}</>}
                  {edition.language && <> · {edition.language}</>}
                  {edition.pageCount > 0 && <> · {edition.pageCount} pages</>}
                  {edition.isbn13 && <> · ISBN {edition.isbn13}</>}
                </li>
              ))}
            </ul>
          )}

          <h3>Offers</h3>
          {work.offers.length === 0 ? (
            <p className="work-empty">No stores currently list this work.</p>
          ) : (
            <ul className="work-offers">
              {work.offers.map((offer) => (
                <li key={offer.listingId.toString()} className="work-offer">
                  <span className="work-offer-store">{offer.storeName}</span>
                  <span className="work-offer-price">${offer.price.toFixed(2)}</span>
                  <span>
                    {offer.stockQuantity > 0
                      ? `${offer.stockQuantity} in stock`
                      : 'out of stock'}
                  </span>
                  {offer.averageRating > 0 && (
                    <span>★ {offer.averageRating.toFixed(1)}</span>
                  )}
                  {offer.totalSold > 0 && <span>{offer.totalSold} sold</span>}
                  {offer.isbn && <span>ISBN {offer.isbn}</span>}
                  {offer.isSynthetic && (
                    <span className="synthetic-badge">Demo data</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h3>Reviews</h3>
          {work.reviews.length === 0 ? (
            <p className="work-empty">No reviews yet.</p>
          ) : (
            <ul className="work-reviews">
              {work.reviews.map((entry) => {
                // Edition attribution (fix round item 11): the
                // editions list is already on this page — name the
                // edition (title/publisher/year) instead of rendering
                // a raw database id ('edition #123').
                const edition = work.editions.find(
                  (e) => e.editionId === entry.editionId,
                );
                return (
                  <li key={entry.review?.id.toString()} className="work-review">
                    <span className="work-review-rating">
                      ★ {entry.review?.rating ?? 0}
                    </span>
                    <span className="work-review-text">{entry.review?.reviewText}</span>
                    <span className="work-review-meta">
                      — {entry.review?.customerName} · via {entry.storeName}
                      {edition && (
                        <>
                          {' '}
                          · edition “{edition.title}”
                          {edition.publisher && <> ({edition.publisher}</>}
                          {edition.publisher && edition.publishYear > 0 && (
                            <>, {edition.publishYear}</>
                          )}
                          {edition.publisher && <>)</>}
                          {!edition.publisher && edition.publishYear > 0 && (
                            <> ({edition.publishYear})</>
                          )}
                        </>
                      )}
                    </span>
                    {entry.isSynthetic && (
                      <span className="synthetic-badge">Demo data</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export default WorkPage;
