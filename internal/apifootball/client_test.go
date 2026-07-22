package apifootball

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestClientAuthenticatesAndDecodesResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("x-apisports-key"); got != "secret" {
			t.Fatalf("x-apisports-key = %q", got)
		}
		json.NewEncoder(w).Encode(map[string]any{"response": []any{map[string]any{"id": 39}}})
	}))
	defer server.Close()

	client := NewClient("secret")
	client.BaseURL = server.URL
	var payload struct {
		Response []struct{ ID int `json:"id"` } `json:"response"`
	}
	if err := client.Get(context.Background(), "/leagues", &payload); err != nil {
		t.Fatal(err)
	}
	if got := payload.Response[0].ID; got != 39 {
		t.Fatalf("id = %d", got)
	}
}

func TestClientRetriesRateLimits(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"response": []any{}})
	}))
	defer server.Close()

	client := NewClient("secret")
	client.BaseURL = server.URL
	client.Sleep = func(time.Duration) {}
	var payload any
	if err := client.Get(context.Background(), "/fixtures", &payload); err != nil {
		t.Fatal(err)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d", attempts)
	}
}
