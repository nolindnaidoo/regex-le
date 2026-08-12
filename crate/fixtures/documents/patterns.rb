# Ruby has the bare literal, so the slash-versus-division walk runs here
NESTED = /(a+)+/
ANCHORED = /^[a-z]+$/i

# And a constructor
BUILT = Regexp.new('(a|ab)+')

# Division, not a regex
def ratio(a, b)
  a / b / 2
end
