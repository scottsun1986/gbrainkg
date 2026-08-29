#!/bin/bash
echo "Waiting for pnpm install (task-166) and docker compose (task-175) to finish..."
# Just loop checking if they are still running, or wait for the lock files.
# But since they are running in the background, we can just check if pnpm process is running.
while pgrep -f pnpm > /dev/null; do sleep 5; done
while pgrep -f "docker compose up" > /dev/null; do sleep 5; done

echo "Running Prisma setup..."
cd packages/database
npx prisma db push
npx prisma generate
npx ts-node prisma/seed.ts
echo "Setup complete!"
