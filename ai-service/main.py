from fastapi import FastAPI
from pydantic import BaseModel
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
import re

app = FastAPI(title="TRACE AI Service", version="1.0")

class AnalyzeRequest(BaseModel):
    text: str

def classify(text: str) -> str:
    t = text.lower()
    rules = {
        "Network": ["wifi", "wi-fi", "internet", "network", "router", "connection", "portal"],
        "Equipment": ["projector", "computer", "laptop", "keyboard", "printer", "equipment", "screen"],
        "Facilities": ["water", "leak", "pipe", "tap", "plumbing"],
        "Cleanliness": ["clean", "garbage", "dust", "washroom", "toilet"],
        "Library": ["library", "book", "borrow", "return"],
        "Security": ["security", "access", "entry", "visitor"]
    }
    for category, words in rules.items():
        if any(word in t for word in words):
            return category
    return "General"

@app.get("/health")
def health():
    return {"ok": True, "service": "TRACE AI"}

@app.post("/analyze")
def analyze(payload: AnalyzeRequest):
    text = payload.text.strip()
    words = re.findall(r"[a-zA-Z]{4,}", text.lower())
    keywords = list(dict.fromkeys(words))[:8]
    # Lightweight baseline: TF-IDF representation for downstream similarity work.
    vector = TfidfVectorizer(stop_words="english")
    try:
        matrix = vector.fit_transform([text, " ".join(keywords) or text])
        confidence = float(cosine_similarity(matrix[0:1], matrix[1:2])[0][0])
    except ValueError:
        confidence = 0.0
    return {
        "category": classify(text),
        "keywords": keywords,
        "method": "python-tfidf-baseline",
        "text_signal": round(confidence, 3),
        "note": "Baseline text analysis. Validate with labelled organization data before production use."
    }
