# User Flows — B2B Audit
### What a human actually does, step by step. Two flows: the operator (you, running an audit) and the prospect (the company receiving one). Everything below already exists as a component somewhere in D018/b2b-change-plan/audit-output-spec/ADR-000 — this document is the missing thing that walks a person through them in order.
### Checked against source docs across two passes; 4 corrections applied inline (marked **corrected on review**/**citation corrected**), two new proposals flagged as new rather than presented as established (marked **new, unsourced**).

---

## FLOW 1 — Operator: running one audit (you, at the internal page)

**Trigger:** you have an AI output + source docs you want audited — either your own teaser material (public samples) or a paying customer's real files (under NDA).

1. **Open `/internal/audit`.** (Not built yet — this flow is what it needs to support.)
2. **Fill intake:** company name, product name, domain (finance/legal/general/healthcare — **corrected on review**: an earlier draft dropped `healthcare`, which is part of the actual `domain` enum in `contracts/audit-endpoint.md`), task/date context, paste or upload the output text, paste or upload the source document(s).
3. **Click Run.** Client calls `POST /audit`. Gets back `202 { audit_id }` immediately — the page must show a visible "running" state here, not a blank screen. (This is the exact gap the last review caught — without `GET /audit/:id`, step 4 has nothing to poll.)
4. **Page polls `GET /audit/:audit_id`** on a backoff interval (per `Retry-After`) until status is `complete` or `failed`.
   - If `failed`: show `failed_stage` + `error_summary`. You decide: retry, fix input, or abandon.
   - If `complete`: render the claims table.
5. **Review pass (mandatory, this is the FP-control step — currently a bullet in a spec, not a described action):** for each claim in the table — claim text, verdict, confidence, evidence quote, source_ref — you personally read the evidence quote against the claim and either **Approve** or **Override** the verdict. Override requires a one-line reason (this becomes a labeled training example — the moat dataset). You do this for every claim above the gate threshold. Gated-out (sub-threshold) claims show as a **count only**, not an expandable list (**corrected on review** — an earlier draft said these were "visible in a collapsed section," implying you could still inspect each one; the actual internal-page spec, `context-prompt-b2b-transformation.md` §3.2, and D018's general gated-candidates rule are both explicit that sub-threshold candidates are logged for later debugging, never surfaced as review-queue items, even to the operator).
   - **Scope note**: this step as drafted covers the grounding claims table only. D018 §3's bias-module verification pass (source_qa) is a second source of overrides once that layer is built — it's out of scope for the current build (008-b2b), so this flow doesn't describe it yet; extend this step when that spec lands rather than assuming it's covered here.
6. **Click "Generate report."** This produces two artifacts: the customer-facing report (markdown → your chosen delivery format) and the **review-prompt** (the standalone verification prompt for the AI quorum).
7. **Run the review-prompt through ≥2 external AI models.** Paste each model's per-finding VALID/INVALID/UNCERTAIN response back into the page (or a tracking sheet if the page doesn't support this yet — v1 can be manual).
8. **Gate check:** any finding not unanimously VALID gets dropped from the report before it ships. This is a hard stop — not a suggestion — per ADR-000 §2/§4 step 7's standing rule.
9. **Send.** Teaser: paste the 3 strongest surviving findings into the cold email template. Paid engagement: attach the full report to the delivery email/doc.
10. **Close out:** for a paid engagement, delete the corpus from the `audit` schema (D018 §2.4); retain only the anonymized overrides from step 5 (and step 5's bias-module counterpart, once built).

**What this flow exposes that no spec did:** step 5 (the human review pass) was a bullet — "approve/override per finding, overrides stored" — with no description of *what you're actually looking at or deciding*. It's the single most important step in the whole pipeline (it's the FP gate) and it had zero UX definition. That's the real gap under the gap.

---

## FLOW 2 — Prospect: receiving and acting on an audit (the customer's side)

**Trigger:** you send a teaser cold email with 3 findings from their public output.

1. **They open the email.** They see: 3 specific claims from *their own* published output, each with the exact contradicting/unsupported evidence. No pitch deck, no jargon — their own words next to the problem.
2. **They react one of three ways** (this determines your funnel, and nothing currently plans for the branches):
   - **Ignore.** → you follow up once, then move to the next target and count this attempt toward the kill-criterion counter (ADR-000 §3: "10+ teaser attempts, zero paid audits → the capability is a feature, not a company"). **New, unsourced** — a specific follow-up cadence (e.g. "~2 weeks") isn't written down anywhere in the existing docs; pick one and write it down rather than deciding it ad hoc per target.
   - **Reply skeptical / dispute a finding.** → you must be able to re-justify that specific finding on the spot — this is why step 7/8 in Flow 1 (the quorum) has to have already happened *before* sending; you cannot improvise a defense of an unreviewed finding in a live reply.
   - **Reply interested.** → proceed to step 3.
3. **20-minute call.** You walk through the 3 teaser findings, explain the method (evidence-binding, FP<10%, silent-on-clean), and pitch the paid audit: $3k, ~40 real outputs, 10 days (ADR-000 §2).
4. **They say yes → NDA + SOW** (gap #2 from `b2b-change-plan.md` §6 — this paperwork has to exist by this point, not be improvised mid-call). They send their real outputs + source documents.
5. **You run Flow 1** on their real data.
6. **Report delivery.** They receive: executive block (Groundedness Score + denominator + contradiction/unsupported rates), the mandatory contradiction-first worked example if any exist, the drill-down table (D018 §4.3), recommendations, and the continuous-check upsell paragraph (**citation corrected on this pass** — an earlier draft attributed this to D018 §4.3, which never mentions it; it's actually ADR-000 §2's go-to-market line — "→ report → continuous-check upsell" — and `audit-output-spec.md` item 8 — "the continuous-API upsell paragraph").
7. **They read it and do one of three things** (also currently undescribed):
   - **Nothing.** → the engagement ends; you have the anonymized labels. **New, unsourced**: using this as a case study, or asking permission to reference the engagement, isn't written down anywhere in the existing docs either — reasonable practice, but a new proposal, not a documented policy; decide whether/when to ask (e.g. at SOW time) rather than treating it as already settled.
   - **Fix internally and thank you.** → same as above, a happy one-off client; asking for a testimonial/referral is the same new-not-sourced proposal as above.
   - **Ask "can this run continuously?"** → this is the upsell trigger: the API/CI integration conversation, which is currently a single paragraph in every report template and has no described sales motion at all past "mention it."
8. **Payment.** Invoice per the SOW terms (gap #2) — net terms, upfront, whatever you set; this hasn't been decided anywhere yet either and it's needed before the first real engagement, not the tenth.

---

## What this document adds that nothing else had

- A concrete UI description for the review pass (Flow 1 step 5) — the FP gate had a data shape but no interaction.
- The polling/failed-state UX on the operator side, matching the API contract the last review just fixed.
- The three-branch prospect reactions (ignore / skeptical / interested) at BOTH the teaser stage and the report stage — six branches total, zero of which existed as a plan before this document. "Skeptical reply" in particular is the branch most likely to actually happen and had no answer.
- The explicit ordering dependency: the quorum review (Flow 1 steps 7-8) MUST complete before send, because Flow 2 step 2's skeptical-reply branch requires you to already have a defensible answer, not construct one live.
- Two named-but-unwritten artifacts this exposes as blocking, not optional: the SOW/NDA template (needed by Flow 2 step 4) and payment terms (Flow 2 step 8) — both were "gap #2" in a list before; this shows exactly where in the human sequence they're load-bearing.

## What's still NOT decided (surfaced by writing this, not resolved by it)

1. Manual quorum tracking in v1 (Flow 1 step 7) is clunky — fine for audit #1, worth a lighter UI by audit #3 or so.
2. The skeptical-reply branch (Flow 2 step 2) has no written response templates — worth drafting 2-3 before the first teaser goes out, not after the first objection arrives.
3. Payment terms and the SOW template are named as blockers here for the second time (first in b2b-change-plan gap #2) and still don't exist. This is now blocking a described human step, not an abstract gap — write it before the pilot-target run.
4. Follow-up cadence (Flow 2 step 2) and reference/testimonial-use policy (Flow 2 step 7) are new proposals introduced by this document, not decisions carried over from anywhere else — flagged inline above, listed again here so they don't get mistaken for settled later.
