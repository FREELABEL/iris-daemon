#!/bin/bash
# Clip Cutter — runs via daemon local schedule
# Calls local Docker fl-api which has ffmpeg + brand assets
# The artisan command queries production DB for fresh Discover content

cd /Users/AlexMayo/Sites/freelabel/fl-docker-dev
docker compose exec -T api php artisan clips:cut-scheduled --brand=discover --threshold=70
