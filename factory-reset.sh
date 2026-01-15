#!/bin/bash
echo "⚠️  WARNING: This will delete ALL GAME SERVERS, BACKUPS, and LOGS!"
read -p "Are you sure you want to continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]
then
    exit 1
fi

echo "Deleting server data..."
rm -rf servers/*

echo "Deleting backups..."
rm -rf backups/*

echo "Clearing logs..."
rm -rf logs/*

echo "Deleting configs (.env, config.json)..."
rm -f .env config.json

echo "✅ Daemon reset complete."
