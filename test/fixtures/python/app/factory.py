import threading

from .models import User
from .repo import UserRepo


def make():
    return UserRepo(), User("x")


def make_repo():
    return UserRepo()


def use():
    repo, user = make()
    repo.get(1)
    user.touch()
    again = make_repo()
    again.get(2)
    return user.display


def work():
    return make_repo()


def start():
    threading.Thread(target=work).start()
