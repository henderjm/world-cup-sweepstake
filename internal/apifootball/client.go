package apifootball

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxRateLimitRetries = 4

type Client struct {
	APIKey  string
	BaseURL string
	HTTP    *http.Client
	Sleep   func(time.Duration)
}

func NewClient(apiKey string) *Client {
	return &Client{
		APIKey:  apiKey,
		BaseURL: "https://v3.football.api-sports.io",
		HTTP:    &http.Client{Timeout: 20 * time.Second},
		Sleep:   time.Sleep,
	}
}

func (c *Client) Get(ctx context.Context, path string, target any) error {
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.BaseURL, "/")+path, nil)
		if err != nil {
			return err
		}
		req.Header.Set("x-apisports-key", c.APIKey)
		response, err := c.HTTP.Do(req)
		if err != nil {
			return err
		}
		if response.StatusCode == http.StatusTooManyRequests && attempt < maxRateLimitRetries {
			response.Body.Close()
			c.Sleep(retryDelay(response.Header.Get("Retry-After")))
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
			response.Body.Close()
			return fmt.Errorf("API-Football %s: %s", response.Status, strings.TrimSpace(string(body)))
		}
		err = json.NewDecoder(response.Body).Decode(target)
		response.Body.Close()
		return err
	}
}

func retryDelay(value string) time.Duration {
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds < 1 {
		return time.Second
	}
	return time.Duration(seconds) * time.Second
}
