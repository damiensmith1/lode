class Greeter
  attr_reader :formatter

  def initialize(name)
    @name = name
    @formatter = Formatter.new
  end

  def greet
    format_name
  end

  def pretty
    formatter.format(@name)
  end

  def again
    self.class.build
    send(:format_name)
  end

  def self.build
    new("x")
  end

  private

  def format_name
    @name.upcase
  end
end
