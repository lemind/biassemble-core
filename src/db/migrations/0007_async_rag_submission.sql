-- Stage 005: Async RAG Submission
-- Migration: Add rag_started_at column to runs

ALTER TABLE core.runs ADD COLUMN IF NOT EXISTS rag_started_at TIMESTAMPTZ;
