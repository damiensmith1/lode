class Comment < ApplicationRecord
  belongs_to :post
  delegate :headline, to: :post
end
