from django.db import models


class Article(models.Model):
    def publish(self):
        self.save()
