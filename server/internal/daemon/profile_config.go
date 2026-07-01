package daemon

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const defaultCLIConfigPath = ".multica/config.json"

// CLIConfig holds persistent profile settings read from
// ~/.multica/config.json (default profile) or
// ~/.multica/profiles/<name>/config.json (named profile). The file is
// shared between the daemon and any tooling that drives it; the daemon
// only ever reads it — server URL, app URL, default workspace, token —
// so only the read side is exported here.
type CLIConfig struct {
	ServerURL   string `json:"server_url,omitempty"`
	AppURL      string `json:"app_url,omitempty"`
	WorkspaceID string `json:"workspace_id,omitempty"`
	Token       string `json:"token,omitempty"`
}

// CLIConfigPathForProfile returns the config file path for the given profile.
// An empty profile returns the default path (~/.multica/config.json).
// A named profile returns ~/.multica/profiles/<name>/config.json.
func CLIConfigPathForProfile(profile string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve profile config path: %w", err)
	}
	if profile == "" {
		return filepath.Join(home, defaultCLIConfigPath), nil
	}
	return filepath.Join(home, ".multica", "profiles", profile, "config.json"), nil
}

// ProfileDir returns the base directory for a profile's state files (pid, log).
// An empty profile returns ~/.multica/. A named profile returns ~/.multica/profiles/<name>/.
func ProfileDir(profile string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve profile dir: %w", err)
	}
	if profile == "" {
		return filepath.Join(home, ".multica"), nil
	}
	return filepath.Join(home, ".multica", "profiles", profile), nil
}

// LoadCLIConfigForProfile reads the profile config for the given profile.
// A missing file is not an error — an empty CLIConfig is returned so
// callers can fall back to defaults / env overrides.
func LoadCLIConfigForProfile(profile string) (CLIConfig, error) {
	path, err := CLIConfigPathForProfile(profile)
	if err != nil {
		return CLIConfig{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return CLIConfig{}, nil
		}
		return CLIConfig{}, fmt.Errorf("read profile config: %w", err)
	}
	var cfg CLIConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return CLIConfig{}, fmt.Errorf("parse profile config: %w", err)
	}
	return cfg, nil
}
