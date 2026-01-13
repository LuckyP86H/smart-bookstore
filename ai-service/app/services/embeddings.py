"""
Embedding generation service using sentence-transformers.
Converts text to vector embeddings for semantic search.
"""

from sentence_transformers import SentenceTransformer
from typing import List
import numpy as np
from app.config.settings import settings


class EmbeddingService:
    """
    Service for generating text embeddings.
    Uses sentence-transformers for high-quality embeddings.
    """
    
    def __init__(self):
        """Initialize the embedding model"""
        print(f"Loading embedding model: {settings.embedding_model}")
        self.model = SentenceTransformer(settings.embedding_model)
        print(f"✅ Embedding model loaded (dimension: {settings.embedding_dimension})")
    
    def generate_embedding(self, text: str) -> List[float]:
        """
        Generate embedding for a single text.
        
        Args:
            text: Input text to embed
            
        Returns:
            List of floats representing the embedding vector
        """
        # Generate embedding
        embedding = self.model.encode(text, convert_to_numpy=True)
        
        # Convert numpy array to list of floats
        return embedding.tolist()
    
    def generate_embeddings_batch(self, texts: List[str]) -> List[List[float]]:
        """
        Generate embeddings for multiple texts efficiently.
        
        Args:
            texts: List of texts to embed
            
        Returns:
            List of embedding vectors
        """
        # Batch encoding is more efficient
        embeddings = self.model.encode(texts, convert_to_numpy=True, show_progress_bar=False)
        
        # Convert to list of lists
        return embeddings.tolist()
    
    def compute_similarity(self, embedding1: List[float], embedding2: List[float]) -> float:
        """
        Compute cosine similarity between two embeddings.
        
        Args:
            embedding1: First embedding vector
            embedding2: Second embedding vector
            
        Returns:
            Similarity score between 0 and 1
        """
        # Convert to numpy arrays
        vec1 = np.array(embedding1)
        vec2 = np.array(embedding2)
        
        # Compute cosine similarity
        # Formula: (A · B) / (||A|| * ||B||)
        dot_product = np.dot(vec1, vec2)
        norm_product = np.linalg.norm(vec1) * np.linalg.norm(vec2)
        
        if norm_product == 0:
            return 0.0
        
        similarity = dot_product / norm_product
        
        # Normalize to [0, 1] range (cosine similarity is [-1, 1])
        return float((similarity + 1) / 2)


# Global embedding service instance (singleton pattern)
# Initialized once when the app starts to avoid reloading the model
_embedding_service = None


def get_embedding_service() -> EmbeddingService:
    """
    Get or create the global embedding service instance.
    Singleton pattern to avoid loading model multiple times.
    """
    global _embedding_service
    if _embedding_service is None:
        _embedding_service = EmbeddingService()
    return _embedding_service
