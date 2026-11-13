.DEFAULT_GOAL := help
CONFIG ?= configs/experiment.json
.PHONY: help build up smoke check plan-test experiment quick down

help:
	@echo "make up          запуск серверов"
	@echo "make smoke       контейнерная smoke-проверка"
	@echo "make check       браузерные функциональные проверки"
	@echo "make experiment  серия измерений из CONFIG"
	@echo "make quick       сокращённая проверка запуска серии"
	@echo "make aa          десять повторений одной конфигурации"
	@echo "make validate    проверка серии, требуется BATCH"
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

.PHONY: analyze
analyze:
	@test -n "$(BATCH)" || (echo "Укажите BATCH=results/raw/имя-серии"; exit 1)
	docker compose --profile analysis run --rm --build analysis --batch "$(BATCH)"

.PHONY: aa validate
aa:
	$(MAKE) experiment CONFIG=configs/aa.json

validate: analyze
	docker compose --profile analysis run --rm --entrypoint python analysis analysis/validate_stand.py --batch "$(BATCH)"
