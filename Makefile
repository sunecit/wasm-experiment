# Все цели выполняются из корня репозитория.
.DEFAULT_GOAL := help
CONFIG ?= configs/experiment.json
.PHONY: help build up smoke check plan-test experiment quick down

help:
	@echo "make up          запуск серверов"
	@echo "make smoke       контейнерная smoke-проверка"
	@echo "make check       браузерные функциональные проверки"
	@echo "make experiment  серия измерений из CONFIG"
	@echo "make quick       сокращённая проверка запуска серии"
	@echo "make down        остановка контейнеров проекта"

build:
	docker compose --profile check --profile experiment build

up:
	docker compose up -d --build --wait web wasm-delivery

smoke: up
	docker compose --profile check run --rm --build checks

check: up
	docker compose --profile check run --rm --build checks node --test sut/browser.test.mjs

plan-test: up
	docker compose --profile check run --rm --build checks node --test runner/plan.test.mjs

experiment: up
	docker compose --profile experiment build experiment
	EXPERIMENT_CONFIG="$(CONFIG)" node runner/launch.mjs

quick:
	$(MAKE) experiment CONFIG=configs/quick.json

down:
	docker compose down
