import pytest

from app.repo import UserRepo


@pytest.fixture
def repo():
    return UserRepo()
