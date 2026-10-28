.PHONY: dev test test-unit test-integration lint run build migrate generate typecheck

dev:
	bun --watch src/index.ts

test:
	bun test --coverage

test-unit:
	bun test tests/unit

test-integration:
	bun test tests/integration

lint:
	bun x eslint src/ tests/

typecheck:
	bun x tsc --noEmit

run:
	bun run src/index.ts

build:
	docker build -t identity_service:latest .

migrate:
	bun x drizzle-kit migrate

generate:
	bun x drizzle-kit generate
