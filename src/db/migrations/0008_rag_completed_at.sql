-- Stage 005: RAG job completion timing
-- Migration: Add rag_completed_at column to runs

ALTER TABLE core.runs ADD COLUMN IF NOT EXISTS rag_completed_at TIMESTAMPTZ;
