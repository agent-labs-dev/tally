#!/usr/bin/env bun
import { main } from "./cli";

process.exit(await main(process.argv.slice(2), { isTTY: process.stdout.isTTY, env: process.env }));
