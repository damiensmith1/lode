from django.urls import path

from . import views

app_name = "blog"

urlpatterns = [
    path("articles/", views.article_list),
    path("articles/<int:pk>/", views.ArticleDetail.as_view(), name="article-detail"),
]
