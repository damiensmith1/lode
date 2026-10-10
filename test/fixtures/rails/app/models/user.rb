class User < ApplicationRecord
  has_many :posts, foreign_key: :author_id

  def activate!
    update!(active: true)
    welcome
  end

  def welcome; end
end
