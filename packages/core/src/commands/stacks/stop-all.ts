// LEV-238 — `stacks stop --all` was promoted to a top-level `nuke` command.
// This file is kept only to preserve git history for the original implementation;
// all functionality now lives in `../nuke.ts`.
export { makeNukeCommand as makeStacksStopAllCommand } from '../nuke';
