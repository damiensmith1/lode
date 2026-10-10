class CommentsController < ApplicationController
  def create
    current_user.posts
  end
end
