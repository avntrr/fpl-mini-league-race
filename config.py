"""Config loader: ambil default dari .env biar gak perlu pass argument terus."""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

from dotenv import load_dotenv

load_dotenv()


@dataclass
class Config:
    league_id: Optional[int]

    @classmethod
    def from_env(cls) -> "Config":
        raw = os.getenv("LEAGUE_ID")
        league_id = int(raw) if raw and raw.strip().isdigit() else None
        return cls(league_id=league_id)
