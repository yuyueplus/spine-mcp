package rooms

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorkspaceRootAliasAndCanonicalSpelling(t *testing.T) {
	parent := t.TempDir()
	realRoot := filepath.Join(parent, "real")
	if err := os.Mkdir(realRoot, 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(parent, "alias")
	if err := os.Symlink(realRoot, alias); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	file := filepath.Join(realRoot, "source.json")
	if err := os.WriteFile(file, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{file, filepath.Join(alias, "source.json")} {
		if _, err := within(alias, input, false); err != nil {
			t.Fatalf("valid workspace alias refused: %v", err)
		}
	}
	if _, err := within(alias, filepath.Join(alias, "new", "nested", "output.ts"), true); err != nil {
		t.Fatal(err)
	}
}

func TestExistingOutputDirectoryLinkCannotEscape(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	for _, output := range []string{link, filepath.Join(link, "nested", "output.ts")} {
		if _, err := within(root, output, true); err == nil {
			t.Fatalf("outside directory link accepted: %s", output)
		}
	}
	if _, err := New(Config{Root: root, Directory: link, Slots: []Slot{{ID: "local", Capacity: 1, MemoryMB: 128}}}); err == nil {
		t.Fatal("room manager accepted an outside existing directory link")
	}
}
