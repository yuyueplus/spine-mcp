package broadcast

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func controlledServer(t *testing.T) (*Server, func()) {
	t.Helper()
	s := &Server{config: Config{Directory: t.TempDir()}, jobs: map[string]*Job{}, requests: map[string]string{}, key: "test-local-control-key"}
	drain := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(drain) }) }
	s.runner = func(string) { <-drain }
	t.Cleanup(func() { release(); s.background.Wait() })
	return s, release
}

func TestSubmissionLocksResultAndKeepsIdempotency(t *testing.T) {
	s, release := controlledServer(t)
	r := referenceRequest()
	j, replay, e := s.Submit(r)
	if e != nil || replay || j.State != "preparing" {
		t.Fatalf("first submission: %+v,%v", j, e)
	}
	r.RegularNumbers[0] = 1
	j.Request.RegularNumbers[1] = 2
	j.Numbers[0] = 3
	s.mu.Lock()
	if s.jobs[j.ID].Numbers[0] != 40 || s.jobs[j.ID].Request.RegularNumbers[0] != 40 || s.jobs[j.ID].Request.RegularNumbers[1] != 48 {
		t.Fatal("caller modified a locked result")
	}
	s.mu.Unlock()
	again, replay, e := s.Submit(referenceRequest())
	if e != nil || !replay || again.ID != j.ID {
		t.Fatal("same request did not return the original job")
	}
	if _, _, e = s.Submit(r); e == nil || e.Error() != "REQUEST_CONFLICT" {
		t.Fatal("conflicting request ID accepted")
	}
	r = referenceRequest()
	r.RoundID, r.RequestID = "demo-002", "request-0002"
	if _, _, e = s.Submit(r); e == nil || e.Error() != "ROUND_LOCKED" {
		t.Fatal("concurrent round accepted")
	}
	stopped, e := s.Stop(j.ID)
	if e != nil || stopped.State != "stopping" {
		t.Fatal("stop did not drain")
	}
	if _, _, e = s.Submit(r); e == nil || e.Error() != "ROUND_LOCKED" {
		t.Fatal("slot released before worker cleanup")
	}
	release()
	s.background.Wait()
	s.mu.Lock()
	if s.jobs[j.ID].State != "cancelled" || s.jobs[j.ID].EndedAt == nil || s.active != "" {
		t.Fatal("stop did not finish or release the slot")
	}
	s.mu.Unlock()
	if _, _, e = s.Submit(r); e != nil {
		t.Fatal("new round rejected after cleanup", e)
	}
}

func TestHTTPGatesAndRequestContract(t *testing.T) {
	s, _ := controlledServer(t)
	h := s.Handler()
	request := func(method, target, body, host, key, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1:8090"+target, strings.NewReader(body))
		r.Host = host
		r.Header.Set("X-Demo-Key", key)
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	body, _ := json.Marshal(referenceRequest())
	for _, test := range []struct {
		name, body, host, key, origin string
		status                        int
	}{
		{"foreign-host", string(body), "foreign.example:8090", s.key, "", 403},
		{"missing-key", string(body), "127.0.0.1:8090", "", "", 403},
		{"foreign-origin", string(body), "127.0.0.1:8090", s.key, "https://foreign.example", 403},
		{"unknown-field", strings.TrimSuffix(string(body), "}") + `,"extra":true}`, "127.0.0.1:8090", s.key, "", 400},
		{"extra-document", string(body) + `{}`, "127.0.0.1:8090", s.key, "", 400},
		{"oversized", `{"padding":"` + strings.Repeat("x", 20000) + `"}`, "127.0.0.1:8090", s.key, "", 400},
		{"accepted", string(body), "127.0.0.1:8090", s.key, "http://127.0.0.1:8090", 202},
		{"idempotent-replay", string(body), "127.0.0.1:8090", s.key, "", 200},
	} {
		t.Run(test.name, func(t *testing.T) {
			w := request("POST", "/api/rounds", test.body, test.host, test.key, test.origin)
			if w.Code != test.status {
				t.Fatalf("got%d, want%d: %s", w.Code, test.status, w.Body.String())
			}
		})
	}
	w := request("GET", "/api/rounds", "", "127.0.0.1:8090", "", "")
	var jobs []Job
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &jobs) != nil || len(jobs) != 1 {
		t.Fatal("job list contract failed")
	}
	w = request("GET", jobs[0].Replay, "", "127.0.0.1:8090", "", "")
	if w.Code != 404 {
		t.Fatal("unfinished replay exposed")
	}
}
