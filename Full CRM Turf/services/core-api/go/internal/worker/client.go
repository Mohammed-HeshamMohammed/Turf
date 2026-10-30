// Package worker runs Caller Whale's scheduling and workflow processing (plan 2.1, Go): it claims outbox events and asks the
// API to run the rules for each, ticks the scheduler, and publishes cache invalidations. It holds no database
// credentials; every change goes through the API's internal routes, which apply the same checks as for people.
package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client calls the API's /internal routes with a worker token.
type Client struct {
	Base  string
	Token string
	HTTP  *http.Client
}

// APIError is a non-2xx answer from the API.
type APIError struct {
	Status int
	Body   string
}

func (e *APIError) Error() string { return fmt.Sprintf("api answered %d: %s", e.Status, e.Body) }

// Post sends body as JSON and decodes the answer into out (when not nil).
func (c *Client) Post(ctx context.Context, path string, body any, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Base+"/internal"+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Worker "+c.Token)
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return err
	}
	if response.StatusCode >= 300 {
		return &APIError{Status: response.StatusCode, Body: string(data)}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}
