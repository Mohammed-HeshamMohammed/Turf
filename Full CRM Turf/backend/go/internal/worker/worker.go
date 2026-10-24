package worker

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// Event is an outbox event as /internal/events/claim returns it.
type Event struct {
	ID       int64  `json:"id"`
	OrgID    string `json:"org_id"`
	Kind     string `json:"kind"`
	Entity   string `json:"entity"`
	EntityID string `json:"entity_id"`
	LeadID   string `json:"lead_id"`
	Depth    int    `json:"depth"`
}

// Publisher announces committed changes to other API instances' caches. Nil disables it.
type Publisher interface {
	Publish(ctx context.Context, channel, message string) error
}

// Config controls the loops.
type Config struct {
	Batch         int
	Concurrency   int
	Idle          time.Duration // wait after an empty claim
	TickEvery     time.Duration // scheduler period
	LeaseSeconds  int
	InvalidateKey string // Redis channel for invalidations
}

// Stats are exposed on the health endpoint.
type Stats struct {
	Processed atomic.Int64
	Failed    atomic.Int64
	Ticks     atomic.Int64
	LastError atomic.Value // string
}

// Worker runs the event and scheduler loops until its context ends.
type Worker struct {
	API       *Client
	Publisher Publisher
	Config    Config
	Stats     Stats
	Log       *slog.Logger
}

// Run blocks until ctx is cancelled, then waits for in-flight work to finish (graceful shutdown).
func (w *Worker) Run(ctx context.Context) {
	var group sync.WaitGroup
	group.Add(2)
	go func() { defer group.Done(); w.events(ctx) }()
	go func() { defer group.Done(); w.scheduler(ctx) }()
	group.Wait()
}

func (w *Worker) note(err error) {
	if err != nil && !errors.Is(err, context.Canceled) {
		w.Stats.LastError.Store(err.Error())
		w.Log.Warn("worker step failed", "error", err)
	}
}

func (w *Worker) events(ctx context.Context) {
	backoff := w.Config.Idle
	for ctx.Err() == nil {
		count, err := w.ProcessBatch(ctx)
		w.note(err)
		if err != nil {
			// The API may be restarting: back off up to a minute.
			backoff = min(backoff*2, time.Minute)
		} else if count > 0 {
			backoff = w.Config.Idle
			continue
		} else {
			backoff = w.Config.Idle
		}
		sleep(ctx, backoff)
	}
}

// ProcessBatch claims up to Batch events and processes them with bounded concurrency. Events of one lead are processed
// in order by one goroutine, so a lead's rules see its changes in sequence.
func (w *Worker) ProcessBatch(ctx context.Context) (int, error) {
	var claimed struct {
		Events []Event `json:"events"`
	}
	if err := w.API.Post(ctx, "/events/claim", map[string]any{"limit": w.Config.Batch, "lease_seconds": w.Config.LeaseSeconds}, &claimed); err != nil {
		return 0, err
	}
	if len(claimed.Events) == 0 {
		return 0, nil
	}
	lanes := map[string][]Event{}
	var order []string
	for _, event := range claimed.Events {
		key := event.LeadID
		if key == "" {
			key = "event:" + event.EntityID
		}
		if _, seen := lanes[key]; !seen {
			order = append(order, key)
		}
		lanes[key] = append(lanes[key], event)
	}
	limit := make(chan struct{}, max(1, w.Config.Concurrency))
	var group sync.WaitGroup
	for _, key := range order {
		lane := lanes[key]
		group.Add(1)
		limit <- struct{}{}
		go func() {
			defer group.Done()
			defer func() { <-limit }()
			for _, event := range lane {
				w.processOne(ctx, event)
			}
		}()
	}
	group.Wait()
	return len(claimed.Events), nil
}

func (w *Worker) processOne(ctx context.Context, event Event) {
	err := w.API.Post(ctx, "/events/"+itoa(event.ID)+"/process", map[string]any{"org_id": event.OrgID}, nil)
	if err != nil {
		// Unprocessed events become claimable again when the lease ends.
		w.Stats.Failed.Add(1)
		w.note(err)
		return
	}
	w.Stats.Processed.Add(1)
	if w.Publisher != nil && w.Config.InvalidateKey != "" {
		message := event.OrgID + " " + event.Entity + " " + event.EntityID
		if err := w.Publisher.Publish(ctx, w.Config.InvalidateKey, message); err != nil {
			// A failed invalidation never blocks work: caches are keyed by revision and expire in 30 seconds.
			w.note(err)
		}
	}
}

func (w *Worker) scheduler(ctx context.Context) {
	for {
		var result map[string]any
		err := w.API.Post(ctx, "/scheduler/tick", map[string]any{}, &result)
		w.note(err)
		if err == nil {
			w.Stats.Ticks.Add(1)
			w.Log.Debug("scheduler tick", "result", result)
		}
		if !sleep(ctx, w.Config.TickEvery) {
			return
		}
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var digits [20]byte
	i := len(digits)
	negative := n < 0
	if negative {
		n = -n
	}
	for n > 0 {
		i--
		digits[i] = byte('0' + n%10)
		n /= 10
	}
	if negative {
		i--
		digits[i] = '-'
	}
	return string(digits[i:])
}
