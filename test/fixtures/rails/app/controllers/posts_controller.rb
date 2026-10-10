class PostsController < ApplicationController
  def index
    @posts = Post.published
  end

  def show
    @post = Post.find(params[:id])
    @post.view!
  end

  def publish
    @post = Post.find(params[:id])
    @post.publish!
    NotifyJob.perform_later(@post.id)
    PostMailer.published(@post).deliver_later
  end
end
