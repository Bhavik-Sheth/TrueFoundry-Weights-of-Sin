def test_index(client):
    assert client.get("/x").status_code == 200
