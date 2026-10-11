from .models import User


class UserRepo:
    def get(self, user_id: int) -> User:
        return User(str(user_id))
