"""TDD test for local (ollama) embedding routing in mmrag.embed_content.
Local path must work with client=None (no Gemini dependency) and return a 768-dim
nomic-embed-text vector for BOTH the document path (embed_content) and the query
path (embed_query). Requires ollama running with nomic-embed-text pulled."""
import sys
sys.path.insert(0, r"C:/Users/cody/cortextos/knowledge-base/scripts")
import mmrag

def test_local_embed_content_routes_to_ollama():
    cfg = {"embedding_model": "local:nomic-embed-text", "embedding_host": "http://localhost:11435", "embedding_dimensions": 768}
    vec = mmrag.embed_content(None, cfg, "Canadian CEWP invoice due date pattern")
    assert isinstance(vec, list), f"expected list, got {type(vec)}"
    assert len(vec) == 768, f"expected 768-dim, got {len(vec)}"
    print("PASS: embed_content local -> 768-dim vector (client=None, no Gemini)")

def test_local_query_path_also_routes_local():
    cfg = {"embedding_model": "local:nomic-embed-text", "embedding_host": "http://localhost:11435"}
    vec = mmrag.embed_query(None, cfg, "what is the payroll ACH pay-list query")
    assert len(vec) == 768, f"expected 768-dim, got {len(vec)}"
    print("PASS: embed_query local -> 768-dim vector")

def test_local_semantic_ranking():
    cfg = {"embedding_model": "local:nomic-embed-text", "embedding_host": "http://localhost:11435"}
    import math
    def cos(a, b):
        d = sum(x*y for x, y in zip(a, b))
        return d / (math.sqrt(sum(x*x for x in a)) * math.sqrt(sum(y*y for y in b)))
    q = mmrag.embed_query(None, cfg, "Canadian CEWP invoice due date")
    rel = mmrag.embed_content(None, cfg, "CEWP Canadian invoices are net-30 from invoice date")
    irr = mmrag.embed_content(None, cfg, "Keystone wall detection skeletonize thin single-line walls")
    assert cos(q, rel) > cos(q, irr), "relevant doc must outrank irrelevant"
    print(f"PASS: semantic ranking relevant {cos(q,rel):.3f} > irrelevant {cos(q,irr):.3f}")

if __name__ == "__main__":
    test_local_embed_content_routes_to_ollama()
    test_local_query_path_also_routes_local()
    test_local_semantic_ranking()
    print("ALL PASS")
