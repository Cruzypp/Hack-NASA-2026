import os

os.environ["ASTRA_AUTOSTART"] = "0"
os.environ["ASTRA_PLAYBACK_S"] = "0"
os.environ["ASTRA_COGNITIVE_TIMESCALE"] = "0"

import pytest
from fastapi.testclient import TestClient

from astra.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(str(tmp_path / "astra.db"), str(tmp_path / "ground.db"), background=False)
    with TestClient(app) as c:
        c.app_state = app.state
        yield c


def login(client, username, pin):
    r = client.post("/auth/login", json={"username": username, "pin": pin})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}
