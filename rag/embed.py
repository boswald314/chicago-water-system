#!/usr/bin/env python3
"""Embed chunks via Ollama on bigmantower (Qwen3-Embedding-4B Q8) into sqlite-vec.
Resumable: skips chunk ids already in the DB. Run inside rag/.venv."""
import json, os, sqlite3, struct, sys, time
import requests
import sqlite_vec

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHUNKS = os.path.join(ROOT, 'rag', 'data', 'chunks.jsonl')
DB = os.path.join(ROOT, 'rag', 'data', 'index.db')
OLLAMA = os.environ.get('OLLAMA_URL', 'http://bigmantower.local:11434')
MODEL = os.environ.get('EMBED_MODEL', 'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q8_0')
DIM = 2560
BATCH = 16

def serialize(vec):
    return struct.pack(f'{len(vec)}f', *vec)

def db_connect():
    db = sqlite3.connect(DB)
    db.enable_load_extension(True)
    sqlite_vec.load(db)
    db.enable_load_extension(False)
    db.execute('CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, file TEXT, page_start INT, page_end INT, text TEXT)')
    db.execute(f'CREATE VIRTUAL TABLE IF NOT EXISTS vec USING vec0(id TEXT PRIMARY KEY, embedding float[{DIM}])')
    db.execute('CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(id UNINDEXED, text)')
    return db

def embed_batch(texts):
    for attempt in range(5):
        try:
            r = requests.post(f'{OLLAMA}/api/embed', json={'model': MODEL, 'input': texts}, timeout=300)
            r.raise_for_status()
            return r.json()['embeddings']
        except Exception as e:
            print(f'  retry {attempt}: {e}', flush=True)
            time.sleep(10 * (attempt + 1))
    raise RuntimeError('embedding failed after retries')

def main():
    db = db_connect()
    have = {r[0] for r in db.execute('SELECT id FROM chunks')}
    todo = []
    for line in open(CHUNKS):
        c = json.loads(line)
        if c['id'] not in have:
            todo.append(c)
    print(f'{len(have)} already embedded; {len(todo)} to go', flush=True)
    t0 = time.time()
    for i in range(0, len(todo), BATCH):
        batch = todo[i:i + BATCH]
        embs = embed_batch([c['text'] for c in batch])
        for c, e in zip(batch, embs):
            if len(e) != DIM:
                raise RuntimeError(f'dim mismatch: {len(e)}')
            db.execute('INSERT OR REPLACE INTO chunks VALUES(?,?,?,?,?)',
                       (c['id'], c['file'], c['page_start'], c['page_end'], c['text']))
            db.execute('INSERT OR REPLACE INTO vec(id, embedding) VALUES(?,?)', (c['id'], serialize(e)))
            db.execute('INSERT INTO fts(id, text) VALUES(?,?)', (c['id'], c['text']))
        db.commit()
        done = i + len(batch)
        rate = done / max(time.time() - t0, 1)
        print(f'{done}/{len(todo)} ({rate:.1f} chunks/s, eta {int((len(todo)-done)/max(rate,0.1)/60)}m)', flush=True)
    print('EMBEDDING COMPLETE', flush=True)

if __name__ == '__main__':
    main()
