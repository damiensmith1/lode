from app.repo import UserRepo
from app.models import User
from app.utils import slugify
from app.tasks import send_welcome


class UserService:
    def __init__(self, repo: UserRepo):
        self.repo = repo

    @staticmethod
    def build() -> "UserService":
        return UserService(UserRepo())

    def find(self, user_id: int) -> User:
        user = self.repo.get(user_id)
        user.touch()
        return user

    def register(self, name: str) -> User:
        user = User(slugify(name))
        user.save()
        send_welcome.delay(user.name)
        return user


def get_service() -> UserService:
    return UserService.build()
