package worker

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

// Redis publishes messages with the RESP protocol over one reconnecting connection. Only PUBLISH is needed, so no
// client library is pulled in.
type Redis struct {
	Addr     string
	Password string
	mu       sync.Mutex
	conn     net.Conn
	reader   *bufio.Reader
}

func command(args ...string) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, arg := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(arg), arg)
	}
	return []byte(b.String())
}

func (r *Redis) connect(ctx context.Context) error {
	dialer := net.Dialer{Timeout: 2 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", r.Addr)
	if err != nil {
		return err
	}
	r.conn, r.reader = conn, bufio.NewReader(conn)
	if r.Password != "" {
		if _, err := r.roundTrip(command("AUTH", r.Password)); err != nil {
			r.close()
			return err
		}
	}
	return nil
}

func (r *Redis) close() {
	if r.conn != nil {
		r.conn.Close()
	}
	r.conn, r.reader = nil, nil
}

func (r *Redis) roundTrip(cmd []byte) (string, error) {
	r.conn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := r.conn.Write(cmd); err != nil {
		return "", err
	}
	line, err := r.reader.ReadString('\n')
	if err != nil {
		return "", err
	}
	line = strings.TrimRight(line, "\r\n")
	if strings.HasPrefix(line, "-") {
		return "", fmt.Errorf("redis: %s", line[1:])
	}
	return line, nil
}

// Publish sends one message, reconnecting once if the connection dropped.
func (r *Redis) Publish(ctx context.Context, channel, message string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for attempt := 0; attempt < 2; attempt++ {
		if r.conn == nil {
			if err := r.connect(ctx); err != nil {
				return err
			}
		}
		if _, err := r.roundTrip(command("PUBLISH", channel, message)); err != nil {
			r.close()
			if attempt == 1 {
				return err
			}
			continue
		}
		return nil
	}
	return nil
}
