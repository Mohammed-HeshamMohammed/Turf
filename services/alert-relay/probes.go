package main

// GET /probes: whether each service answers its health check, as the monitoring stack already measures it (the blackbox exporter,
// job "services" in prometheus.yml, every 15 seconds). Auth's public status page reads it, so no service has to probe the others
// itself and Prometheus stays on the monitoring resource's private network. Read-only, up or down per health address only.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"
)

const (
	// A service is down when every check of the last 45 seconds failed (three in a row), so one slow answer is not an outage.
	downQuery = `max_over_time(probe_success{job="services"}[45s])`
	// When it was last up, looked for over the last day.
	lastUpQuery = `max_over_time((timestamp(probe_success{job="services"} == 1))[1d:15s])`
	probesFresh = 15 * time.Second
)

type probe struct {
	Target string `json:"target"`
	Up     bool   `json:"up"`
	Since  int64  `json:"since,omitempty"` // down: the last time it was up (Unix seconds), when known
}

type probeCache struct {
	mu     sync.Mutex
	at     time.Time
	answer []probe
}

// probes answers from a copy at most 15 seconds old; Prometheus is asked again when it is older.
func (s *server) probes(w http.ResponseWriter, r *http.Request) {
	s.cache.mu.Lock()
	defer s.cache.mu.Unlock()
	if s.cache.answer == nil || s.now().Sub(s.cache.at) >= probesFresh {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		answer, err := s.askPrometheus(ctx)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":"the monitoring data could not be read"}`))
			return
		}
		s.cache.answer, s.cache.at = answer, s.now()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"probes": s.cache.answer, "checked_at": s.cache.at.Unix()})
}

func (s *server) askPrometheus(ctx context.Context) ([]probe, error) {
	now, err := s.query(ctx, downQuery)
	if err != nil {
		return nil, err
	}
	out := []probe{}
	anyDown := false
	for target, v := range now {
		out = append(out, probe{Target: target, Up: v >= 1})
		anyDown = anyDown || v < 1
	}
	if anyDown {
		lastUp, err := s.query(ctx, lastUpQuery)
		if err != nil {
			return nil, err
		}
		for i, p := range out {
			if !p.Up {
				out[i].Since = int64(lastUp[p.Target])
			}
		}
	}
	return out, nil
}

// query runs one instant query and answers its value per instance label.
func (s *server) query(ctx context.Context, q string) (map[string]float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.prometheus+"/api/v1/query?query="+url.QueryEscape(q), nil)
	if err != nil {
		return nil, err
	}
	res, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("prometheus answered %d", res.StatusCode)
	}
	var body struct {
		Status string `json:"status"`
		Data   struct {
			Result []struct {
				Metric map[string]string `json:"metric"`
				Value  [2]any            `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil || body.Status != "success" {
		return nil, fmt.Errorf("prometheus answered something unexpected: %v", err)
	}
	out := map[string]float64{}
	for _, r := range body.Data.Result {
		text, _ := r.Value[1].(string)
		if v, err := strconv.ParseFloat(text, 64); err == nil {
			out[r.Metric["instance"]] = v
		}
	}
	return out, nil
}
