from django.urls import path

from . import views

urlpatterns = [
    path("articles/", views.article_list),
    path("articles/<int:pk>/", views.ArticleDetail.as_view()),
]
