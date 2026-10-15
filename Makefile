SHELL := /bin/sh
.DEFAULT_GOAL := help

.PHONY: help install fixtures dev dev-renderer typecheck test build test-e2e package-mac test-packaged check verify

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*## "; printf "Usage: make <target>\n\n"} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install locked workspace dependencies and prepare Electron
	npm ci --ignore-scripts
	npm run runtime:prepare

fixtures: ## Install isolated SSH test dependencies and build the Docker fixture
	npm --prefix spikes/ssh-compat ci --omit=optional --ignore-scripts
	docker build -t ssterm-ssh-fixture:m0 tests/fixtures/ssh

dev: ## Start Electron with the React development renderer
	npm run dev

dev-renderer: ## Start the renderer/showcase on 127.0.0.1:5173
	npm run dev:renderer

typecheck: ## Check desktop, workspace and test types
	npm run typecheck

test: ## Run unit tests, including isolated test Keychain checks
	npm test

build: ## Build main, preload and renderer
	npm run build

test-e2e: build ## Build and run Electron E2E tests (requires fixtures)
	npm run test:e2e

package-mac: ## Build the unsigned macOS arm64 app
	npm run package:mac

test-packaged: package-mac ## Build and test the packaged app (requires fixtures)
	npm run test:packaged

check: ## Run typecheck, unit tests and build in order
	$(MAKE) typecheck
	$(MAKE) test
	$(MAKE) build

verify: ## Run all checks, Electron E2E and packaged tests in order
	$(MAKE) check
	npm run test:e2e
	$(MAKE) test-packaged
