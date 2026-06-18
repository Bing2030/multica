// Package analytics defines the product event model consumed by the
// Prometheus metrics layer (see server/internal/metrics). Events describe
// the acquisition → activation → expansion funnel and carry the join /
// segmentation fields the Prometheus counters read.
//
// The PostHog transport that previously shipped these events to an external
// analytics backend has been removed; only the event definitions remain.
package analytics

import "time"

// Event is a single analytics capture. Fields mirror the historical PostHog
// /capture/ shape but are framework-agnostic; the Prometheus dispatcher reads
// Name and Properties.
type Event struct {
	// Name of the event (e.g. "signup", "workspace_created").
	Name string

	// DistinctID identifies the person this event belongs to. For logged-in
	// users this is user.id; for anonymous events it should be the anon_id
	// that was previously used on the frontend so identity merging works.
	DistinctID string

	// WorkspaceID scopes the event to a workspace. Required when the event is
	// about a workspace-level action (workspace_created, issue_executed, ...).
	// Empty is allowed for pre-workspace events (signup).
	WorkspaceID string

	// Properties is the free-form bag of event attributes. Only serialisable
	// values (string, number, bool, nested maps/slices of the same) should
	// go here. Never put raw PII like full emails here — use email_domain.
	Properties map[string]any

	// SetOnce properties attach to the person record and are only written the
	// first time they appear. Use this for acquisition attribution
	// (initial_utm_source, etc.) so later events don't overwrite the origin.
	SetOnce map[string]any

	// Set properties attach to the person record and overwrite on every write.
	// Use this for mutable cohort signals (role, use_case, platform_preference)
	// that users can legitimately change during onboarding.
	Set map[string]any

	// Timestamp is optional; when zero the client fills in time.Now().
	Timestamp time.Time
}
