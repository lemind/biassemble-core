# Inngest Jobs Skill

Load this when working with background jobs, async tasks, or eval triggers.

## Setup

- **Inngest client**: `src/jobs/client.ts`
- **Job definitions**: `src/jobs/` directory
- **Register all jobs**: `src/jobs/inngest-functions.ts`

## Patterns

- **Jobs are async** — never block the HTTP response waiting for a job
- **Eval job runs real provider** — never mock inside Inngest jobs
- **Error handling**: Jobs should retry on transient failures, fail fast on permanent errors

## Adding a New Job

1. Create job file in `src/jobs/`
2. Define job function with Inngest decorator
3. Register in `src/jobs/inngest-functions.ts`
4. Add trigger endpoint or schedule

## Testing

- Mock Inngest client in unit tests
- Integration tests should verify job registration
- Real job execution requires Inngest dev server or production deployment
