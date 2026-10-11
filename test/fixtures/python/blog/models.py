from django.db import models


class ArticleQuerySet(models.QuerySet):
    def published(self):
        return self.filter(draft=False)


class Article(models.Model):
    objects = ArticleQuerySet.as_manager()

    def publish(self):
        self.save()
