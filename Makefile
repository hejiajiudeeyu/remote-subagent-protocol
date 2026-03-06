SHELL := /bin/zsh

COMPOSE_FILE ?= docker-compose.yml
COMPOSE ?= docker compose -f $(COMPOSE_FILE)

.PHONY: up down restart logs ps build clean deploy test test-unit test-integration test-e2e test-e2e-ui test-flow-ui test-compose-smoke test-compose-smoke-strict test-all test-ci

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

restart: down up

logs:
	$(COMPOSE) logs -f --tail=200

ps:
	$(COMPOSE) ps

build:
	$(COMPOSE) build

clean:
	$(COMPOSE) down -v --remove-orphans

deploy:
	@echo "Deploy shortcut (current profile uses docker compose single-host deployment)."
	$(COMPOSE) up -d --build

test:
	npm run test

test-unit:
	npm run test:unit

test-integration:
	npm run test:integration

test-e2e:
	npm run test:e2e

test-e2e-ui:
	npm run test:e2e:ui

test-flow-ui:
	npm run test:flow:dashboard

test-compose-smoke:
	npm run test:compose-smoke

test-compose-smoke-strict:
	npm run test:compose-smoke:strict

test-all:
	npm run test:all

test-ci:
	npm run test:ci
