package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"squad-goals/internal/apifootball"
)

func main() {
	interval := flag.Duration("interval", 0, "minimum delay between API requests")
	flag.Parse()
	if flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: api-football [--interval duration] /path [...]")
		os.Exit(2)
	}
	key := os.Getenv("API_FOOTBALL_KEY")
	if key == "" {
		fmt.Fprintln(os.Stderr, "API_FOOTBALL_KEY is not set")
		os.Exit(2)
	}

	client := apifootball.NewClient(key)
	responses := make([]json.RawMessage, 0, flag.NArg())
	for index, path := range flag.Args() {
		if index > 0 && *interval > 0 {
			time.Sleep(*interval)
		}
		var payload json.RawMessage
		if err := client.Get(context.Background(), path, &payload); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		responses = append(responses, payload)
	}
	if err := json.NewEncoder(os.Stdout).Encode(responses); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
